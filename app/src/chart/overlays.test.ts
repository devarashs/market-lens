/* Draw-function geometry tests against a recording mock context. These
   pin the ported logic (anchoring, scaling, thresholds, side colors) —
   the on-screen result was verified by eye in the vanilla client the
   functions were ported from. */

import { describe, expect, it } from "vitest";

import type { DepthMessage, HeatCol, Trade } from "../lib/types";
import {
  drawBubbles, drawDepth, drawProfile, drawWallLines, groupTradeMarks,
  wallStartTime, MAX_TRADE_LABELS, type DrawEnv,
} from "./overlays";

interface Rect { x: number; y: number; w: number; h: number; style: string }
interface Label { text: string; x: number; y: number; style: string }

function recordingContext() {
  const rects: Rect[] = [];
  const labels: Label[] = [];
  const context = {
    fillStyle: "",
    font: "",
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) });
    },
    fillText(text: string, x: number, y: number) {
      labels.push({ text, x, y, style: String(this.fillStyle) });
    },
  };
  return { context: context as unknown as CanvasRenderingContext2D, rects, labels };
}

/** Linear mappers over a 1000×500 viewport: price 100..200 top-to-bottom,
    time 0..1000s left-to-right. */
function makeEnv() {
  const under = recordingContext();
  const over = recordingContext();
  const env: DrawEnv = {
    under: under.context,
    over: over.context,
    width: 1000,
    height: 500,
    priceToY: (price) => (price < 100 || price > 200 ? null : (200 - price) * 5),
    timeToX: (time) => (time < 0 || time > 1000 ? null : time),
  };
  return { env, under, over };
}

function depthMessage(partial: Partial<DepthMessage>): DepthMessage {
  return {
    type: "depth", symbol: "BTC", venues: [], activeVenues: [], bin: 10,
    bids: [], asks: [], mid: 150, imbalance: null,
    walls: { bids: [], asks: [] }, best: {}, vwap: null,
    pressure: { buy: 0, sell: 0 }, profile: [],
    signals: {
      tape: { score: 0 }, book: { score: 0 },
      combined: { score: 0, verdict: "" },
    },
    ...partial,
  };
}

describe("drawDepth", () => {
  it("anchors bars at the right edge, colored by side, sqrt-scaled", () => {
    const { env, under } = makeEnv();
    drawDepth(env, depthMessage({
      bids: [[140, 1_000_000]],
      asks: [[160, 250_000]], // quarter the size → half the width (sqrt)
    }));
    expect(under.rects).toHaveLength(2);
    const [bid, ask] = under.rects;
    expect(bid.style).toContain("63,163,108");
    expect(ask.style).toContain("196,86,74");
    expect(bid.x + bid.w).toBeCloseTo(1000); // flush right
    expect(bid.w).toBeCloseTo(175);          // max level gets full length
    expect(ask.w).toBeCloseTo(87.5);         // sqrt(1/4) = 1/2
    expect(bid.y).toBeCloseTo((200 - 140) * 5 - 1.5);
  });

  it("skips levels outside the viewport", () => {
    const { env, under } = makeEnv();
    drawDepth(env, depthMessage({ bids: [[90, 1_000_000]] })); // below range
    expect(under.rects).toHaveLength(0);
  });
});

describe("drawBubbles", () => {
  const trade = (notional: number, ts = 500_000): Trade => ({
    ts, venue: "binance", side: "buy", price: 150, size: 1, notional,
  });

  it("filters below-threshold trades and snaps time to the bucket", () => {
    const { env, under } = makeEnv();
    drawBubbles(env, [trade(50_000), trade(200_000, 501_500)], 100_000, "1m");
    expect(under.rects).toHaveLength(1);
    // 501.5s snapped down to the 480s bucket, then offset half a slot
    // (60s wide here) so the dash sits beside the candle, not through it.
    expect(under.rects[0].x).toBeCloseTo(510);
  });

  it("draws dashes UNDER the candles and labels over them", () => {
    // The contract behind the change: a candle is always painted on top
    // of its prints, so heavy flow can never hide price.
    const { env, under, over } = makeEnv();
    drawBubbles(env, [trade(600_000)], 100_000, "1m");
    expect(under.rects).toHaveLength(1);
    expect(over.rects).toHaveLength(0);
    expect(over.labels).toHaveLength(1);
  });

  it("merges prints sharing a bucket and price into one sized mark", () => {
    const { env, under } = makeEnv();
    const many = Array.from({ length: 40 }, () => trade(200_000));
    drawBubbles(env, many, 100_000, "1m");
    // Forty overlapping bars were what buried the candles; now it is one.
    expect(under.rects).toHaveLength(1);
  });

  it("keeps separate prices apart", () => {
    const { env, under } = makeEnv();
    drawBubbles(env, [
      { ...trade(200_000), price: 150 },
      { ...trade(200_000), price: 120 },
    ], 100_000, "1m");
    expect(under.rects).toHaveLength(2);
  });

  it("takes the dominant side when a level has both", () => {
    const { env, under } = makeEnv();
    drawBubbles(env, [
      { ...trade(200_000), side: "buy" as const },
      { ...trade(900_000), side: "sell" as const },
    ], 100_000, "1m");
    expect(under.rects).toHaveLength(1);
    expect(under.rects[0].style).toContain("196,86,74"); // sell red wins
  });

  it("labels only monsters, and caps how many", () => {
    const { env, over } = makeEnv();
    const monsters = Array.from({ length: 12 }, (_, index) => ({
      ...trade(600_000 + index * 10_000),
      price: 110 + index * 5, // distinct prices so they do not merge
    }));
    drawBubbles(env, [...monsters, trade(200_000, 800_000)], 100_000, "1m");
    expect(over.labels).toHaveLength(MAX_TRADE_LABELS);
    // Largest first: the biggest monster is labelled, the 2x print is not.
    expect(over.labels[0].text).toBe("$710K");
  });
});

describe("groupTradeMarks", () => {
  it("sums notional and reports the dominant side", () => {
    const [mark] = groupTradeMarks([
      { x: 100, y: 200, usd: 30_000, side: "buy" },
      { x: 100, y: 201, usd: 50_000, side: "buy" },
      { x: 100, y: 202, usd: 10_000, side: "sell" },
    ]);
    expect(mark.usd).toBe(90_000);
    expect(mark.side).toBe("buy");
  });

  it("separates marks further apart than the bin", () => {
    expect(groupTradeMarks([
      { x: 100, y: 200, usd: 1, side: "buy" },
      { x: 100, y: 260, usd: 1, side: "buy" },
    ])).toHaveLength(2);
  });

  it("separates marks in different time buckets at the same price", () => {
    expect(groupTradeMarks([
      { x: 100, y: 200, usd: 1, side: "buy" },
      { x: 400, y: 200, usd: 1, side: "buy" },
    ])).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(groupTradeMarks([])).toEqual([]);
  });
});

describe("wallStartTime", () => {
  const col = (when: number, prices: number[]): HeatCol =>
    [when, prices.map((p) => [p, 1000]), []];

  it("walks back through continuous presence only", () => {
    const heat = [col(10, [150]), col(20, []), col(30, [150]), col(40, [150])];
    expect(wallStartTime(heat, 150, 5)).toBe(30); // gap at t=20 stops the walk
  });

  it("returns null when absent from the latest column", () => {
    const heat = [col(10, [150]), col(20, [999])];
    expect(wallStartTime(heat, 150, 5)).toBeNull();
  });
});

describe("drawWallLines", () => {
  it("runs the line from first-seen to the right edge, label on the over plane", () => {
    const { env, under, over } = makeEnv();
    const heat: HeatCol[] = [[300, [[140, 1000]], []], [400, [[140, 1000]], []]];
    drawWallLines(env, depthMessage({
      walls: { bids: [[140, 2_000_000, {}]], asks: [] },
    }), heat);
    expect(under.rects).toHaveLength(1);
    expect(under.rects[0].x).toBeCloseTo(300);            // first-seen column
    expect(under.rects[0].w).toBeCloseTo(1000 - 300);     // to the right edge
    expect(over.labels[0].text).toBe("$2.00M");
  });

  it("draws a right-side stub when the ring has no history", () => {
    const { env, under } = makeEnv();
    drawWallLines(env, depthMessage({
      walls: { bids: [[140, 2_000_000, {}]], asks: [] },
    }), []);
    expect(under.rects[0].x).toBeCloseTo(550); // width * 0.55
  });
});

describe("drawProfile", () => {
  it("splits the bar by buy/sell share on the left edge", () => {
    const { env, under } = makeEnv();
    drawProfile(env, depthMessage({ profile: [[150, 750_000, 250_000]] }));
    expect(under.rects).toHaveLength(2);
    const [buy, sell] = under.rects;
    expect(buy.x).toBe(0);
    expect(buy.w / (buy.w + sell.w)).toBeCloseTo(0.75); // 75% buy share
    expect(buy.style).toContain("63,163,108");
    expect(sell.style).toContain("196,86,74");
  });
});

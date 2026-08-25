/* Canvas overlay draw functions — ported from the vanilla client where
   every visual was already verified by eye. Pure: they receive contexts,
   a coordinate mapper, and data slices; no store, no chart object, no DOM
   lookups. The two-plane split is the load-bearing design decision:
   `under` (claims — heat, order lines, profile, depth) paints beneath the
   chart's transparent canvases, `over` (facts — trade dashes, labels)
   paints above them. Lightweight Charts' internal canvases hold z-index
   1/2, so the over-plane sits at z-index 3 (see styles.css). */

import { COLORS, TF_SECONDS, type Timeframe } from "../lib/config";
import { formatUsd } from "../lib/format";
import type { DepthMessage, HeatCol, Trade } from "../lib/types";

export interface DrawEnv {
  under: CanvasRenderingContext2D;
  over: CanvasRenderingContext2D;
  width: number;
  height: number;
  priceToY(price: number): number | null;
  timeToX(timeSeconds: number): number | null;
}

/** Liquidity through time in LINE style: each price level draws as a 1px
    streak spanning column-to-column, so persistent walls read as long
    faint horizontal lines and pulled walls simply end. Claims layer —
    deliberately faint. */
export function drawHeat(env: DrawEnv, heat: HeatCol[]): void {
  for (let i = 0; i < heat.length; i++) {
    const [when, bids, asks] = heat[i];
    const x1 = env.timeToX(when);
    if (x1 === null) continue;
    const nextWhen = i + 1 < heat.length ? heat[i + 1][0] : null;
    const x2raw = nextWhen !== null ? env.timeToX(nextWhen) : null;
    const x2 = x2raw !== null ? x2raw : Math.min(env.width, x1 + 8);
    const colMax = Math.max(...bids.map((b) => b[1]), ...asks.map((a) => a[1]), 1);
    for (const [levels, rgb] of [[bids, COLORS.bidRgb], [asks, COLORS.askRgb]] as const) {
      for (const [price, usd] of levels) {
        const y = env.priceToY(price);
        if (y === null || y < 0 || y > env.height) continue;
        const alpha = Math.min(0.4, Math.sqrt(usd / colMax) * 0.4);
        env.under.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        env.under.fillRect(x1, y, Math.max(1, x2 - x1), 1);
      }
    }
  }
}

/** Walk the heat ring backwards from now: a wall's line starts where the
    level first shows continuous presence. Null with no history. */
export function wallStartTime(heat: HeatCol[], price: number, bin: number): number | null {
  let start: number | null = null;
  for (let i = heat.length - 1; i >= 0; i--) {
    const [when, bids, asks] = heat[i];
    const present = [...bids, ...asks].some(([p]) => Math.abs(p - price) <= bin);
    if (!present) break;
    start = when;
  }
  return start;
}

/** Current top resting walls as bright horizontal ORDER LINES running from
    where the ring first saw them to the right edge. The brightest claims:
    these are the levels price negotiates with. Lines paint under candles,
    their $-labels above. */
export function drawWallLines(env: DrawEnv, depth: DepthMessage, heat: HeatCol[]): void {
  const bin = depth.bin || 1;
  const walls = [
    ...(depth.walls?.bids ?? []).map(([price, usd]) => ({ price, usd, rgb: COLORS.bidRgb })),
    ...(depth.walls?.asks ?? []).map(([price, usd]) => ({ price, usd, rgb: COLORS.askRgb })),
  ];
  const maxUsd = Math.max(...walls.map((wall) => wall.usd), 1);
  for (const wall of walls) {
    const y = env.priceToY(wall.price);
    if (y === null || y < 0 || y > env.height) continue;
    const start = wallStartTime(heat, wall.price, bin);
    let x1 = start !== null ? env.timeToX(start) : null;
    if (x1 === null) x1 = Math.max(0, env.width * 0.55); // no history: short stub
    const thickness = Math.max(1.5, Math.sqrt(wall.usd / maxUsd) * 4.5);
    env.under.fillStyle = `rgba(${wall.rgb},0.55)`;
    env.under.fillRect(x1, y - thickness / 2, env.width - x1, thickness);
    env.over.font = "10px sans-serif";
    env.over.fillStyle = `rgba(${wall.rgb},0.95)`;
    env.over.fillText(
      "$" + formatUsd(wall.usd), Math.max(x1 + 4, env.width - 235), y - 4);
  }
}

/** Executed volume by price along the left edge — the FACTS layer. Green
    segment = aggressive buys, red = sells, at each price bin. */
export function drawProfile(env: DrawEnv, depth: DepthMessage): void {
  const rows = depth.profile ?? [];
  const maxTotal = Math.max(...rows.map(([, buy, sell]) => buy + sell), 1);
  for (const [price, buyUsd, sellUsd] of rows) {
    const y = env.priceToY(price);
    if (y === null || y < 0 || y > env.height) continue;
    const total = buyUsd + sellUsd;
    const width = Math.sqrt(total / maxTotal) * 110;
    const buyWidth = total ? width * (buyUsd / total) : 0;
    env.under.fillStyle = `rgba(${COLORS.bidRgb},0.55)`;
    env.under.fillRect(0, y - 2, buyWidth, 4);
    env.under.fillStyle = `rgba(${COLORS.askRgb},0.55)`;
    env.under.fillRect(buyWidth, y - 2, width - buyWidth, 4);
  }
}

/** Current aggregated book as right-edge bars (resting claims, live). */
export function drawDepth(env: DrawEnv, depth: DepthMessage): void {
  const levels = [
    ...depth.bids.map(([price, usd]) => ({ price, usd, rgb: COLORS.bidRgb })),
    ...depth.asks.map(([price, usd]) => ({ price, usd, rgb: COLORS.askRgb })),
  ];
  const maxUsd = Math.max(...levels.map((level) => level.usd), 1);
  for (const level of levels) {
    const y = env.priceToY(level.price);
    if (y === null || y < 0 || y > env.height) continue;
    const width = Math.max(2, Math.sqrt(level.usd / maxUsd) * 175);
    env.under.fillStyle = `rgba(${level.rgb},0.45)`;
    env.under.fillRect(env.width - width, y - 1.5, width, 3);
  }
}

/** Executed big trades as short BRIGHT horizontal dashes at their actual
    fill price — thickness/length grow with magnitude. Deliberately the
    opposite visual class from the heat lines: long+faint = resting
    claims, short+bright = executed facts. Labels only for monsters (≥5×
    the threshold). */
export function drawBubbles(
  env: DrawEnv, trades: Trade[], threshold: number, timeframe: Timeframe,
): void {
  const bucket = TF_SECONDS[timeframe];
  for (const trade of trades) {
    if (trade.notional < threshold) continue;
    const snapped = Math.floor(trade.ts / 1000 / bucket) * bucket;
    const x1 = env.timeToX(snapped);
    const y = env.priceToY(trade.price);
    if (x1 === null || y === null || y < 0 || y > env.height) continue;
    const magnitude = trade.notional / threshold;
    const length = Math.min(90, 10 + Math.sqrt(magnitude) * 16);
    const thickness = Math.min(5, 1 + Math.sqrt(magnitude) * 1.2);
    const alpha = Math.min(0.9, 0.45 + Math.sqrt(magnitude) * 0.25);
    const rgb = trade.side === "buy" ? COLORS.bidRgb : COLORS.askRgb;
    env.over.fillStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
    env.over.fillRect(x1, y - thickness / 2, length, thickness);
    if (magnitude >= 5) {
      env.over.font = "10px sans-serif";
      env.over.fillText("$" + formatUsd(trade.notional), x1 + length + 4, y + 3);
    }
  }
}

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
import type { DepthMessage, HeatCol, LiqBand, LiqEvent, Trade } from "../lib/types";
import type { StopCluster, Sweep } from "../lib/qlh";

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

/** ESTIMATED liquidation density as full-width violet bands (claims-of-
    claims layer — see liqmap.py for the method and its assumptions).
    Intensity scales with estimated notional; hue leans magenta where longs
    would die (below price) and blue-violet where shorts would (above). */
export function drawLiqMap(env: DrawEnv, bands: LiqBand[]): void {
  const maxUsd = Math.max(...bands.map(([, l, s]) => l + s), 1);
  for (const [price, longUsd, shortUsd] of bands) {
    const y = env.priceToY(price);
    if (y === null || y < 0 || y > env.height) continue;
    const total = longUsd + shortUsd;
    const alpha = Math.min(0.35, Math.sqrt(total / maxUsd) * 0.35);
    const rgb = longUsd >= shortUsd ? COLORS.liqLongRgb : COLORS.liqShortRgb;
    env.under.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
    env.under.fillRect(0, y - 1.5, env.width, 3);
  }
}

/** REAL forced liquidations as X marks at their fill price — the facts
    the estimator answers to. Size grows with notional; monsters (≥$250K)
    get a printed label. */
export function drawLiqPrints(
  env: DrawEnv, liqs: LiqEvent[], timeframe: Timeframe,
): void {
  const bucket = TF_SECONDS[timeframe];
  for (const liq of liqs) {
    const snapped = Math.floor(liq.ts / 1000 / bucket) * bucket;
    const x = env.timeToX(snapped);
    const y = env.priceToY(liq.price);
    if (x === null || y === null || y < 0 || y > env.height) continue;
    const arm = Math.min(8, 3 + Math.sqrt(liq.notional / 100_000) * 3);
    const rgb = liq.side === "long" ? COLORS.liqLongRgb : COLORS.liqShortRgb;
    env.over.strokeStyle = `rgba(${rgb},0.9)`;
    env.over.lineWidth = 1.5;
    env.over.beginPath();
    env.over.moveTo(x - arm, y - arm);
    env.over.lineTo(x + arm, y + arm);
    env.over.moveTo(x - arm, y + arm);
    env.over.lineTo(x + arm, y - arm);
    env.over.stroke();
    if (liq.notional >= 250_000) {
      env.over.font = "10px sans-serif";
      env.over.fillStyle = `rgba(${rgb},0.95)`;
      env.over.fillText(
        `${liq.side === "long" ? "▼" : "▲"}liq $${formatUsd(liq.notional)}`,
        x + arm + 3, y + 3);
    }
  }
}

/** Executed big trades as short BRIGHT horizontal dashes at their actual
    fill price — thickness/length grow with magnitude. Deliberately the
    opposite visual class from the heat lines: long+faint = resting
    claims, short+bright = executed facts. Labels only for monsters (≥5×
    the threshold). */
export interface TradeMark {
  x: number;
  y: number;
  usd: number;
  side: "buy" | "sell";
}

/** How many $-labels a frame may draw, largest first. Every qualifying
    print carrying its own label is what turned the chart into a wall of
    text (Arash, 2026-08-26). */
export const MAX_TRADE_LABELS = 5;
/** Prints landing within this many pixels vertically, in the same time
    bucket, merge into one mark. */
export const TRADE_MARK_BIN_PX = 5;

/** Merge prints that would draw on top of each other into one mark whose
    size is their combined notional, keeping whichever side dominates.

    Fifty prints at one level used to draw fifty overlapping bars, which
    is what buried the candles — a solid slab that said "lots happened
    here" far less clearly than one correctly-sized mark does. */
export function groupTradeMarks(
  entries: TradeMark[], binPx: number = TRADE_MARK_BIN_PX,
): TradeMark[] {
  const groups = new Map<string, { x: number; y: number; buy: number; sell: number }>();
  for (const entry of entries) {
    const row = Math.round(entry.y / binPx);
    const key = `${Math.round(entry.x)}|${row}`;
    let group = groups.get(key);
    if (!group) {
      group = { x: entry.x, y: row * binPx, buy: 0, sell: 0 };
      groups.set(key, group);
    }
    if (entry.side === "buy") group.buy += entry.usd;
    else group.sell += entry.usd;
  }
  return [...groups.values()].map((group) => ({
    x: group.x,
    y: group.y,
    usd: group.buy + group.sell,
    side: group.buy >= group.sell ? "buy" : "sell",
  }));
}

/** Big prints as horizontal dashes at their price.

    Two deliberate choices, both from candles becoming invisible behind
    them: the dashes paint on the UNDER plane so a candle is always drawn
    on top of them — the same split drawWallLines uses — and they start
    half a bar-slot to the right, so the mark sits beside its candle
    rather than through it. Labels stay on the over plane, capped. */
export function drawBubbles(
  env: DrawEnv, trades: Trade[], threshold: number, timeframe: Timeframe,
): void {
  const bucket = TF_SECONDS[timeframe];
  const entries: TradeMark[] = [];
  for (const trade of trades) {
    if (trade.notional < threshold) continue;
    const snapped = Math.floor(trade.ts / 1000 / bucket) * bucket;
    const x1 = env.timeToX(snapped);
    const y = env.priceToY(trade.price);
    if (x1 === null || y === null || y < 0 || y > env.height) continue;
    // Offset into the right half of the bar's slot: clear of the candle
    // body, still unambiguously that candle's print.
    const nextX = env.timeToX(snapped + bucket);
    const slot = nextX !== null && nextX > x1 ? nextX - x1 : 8;
    entries.push({ x: x1 + slot * 0.5, y, usd: trade.notional, side: trade.side });
  }

  const marks = groupTradeMarks(entries);
  marks.sort((a, b) => b.usd - a.usd);
  env.over.font = "10px sans-serif";
  marks.forEach((mark, index) => {
    const magnitude = mark.usd / threshold;
    const length = Math.min(90, 10 + Math.sqrt(magnitude) * 16);
    const thickness = Math.min(4, 1 + Math.sqrt(magnitude));
    const alpha = Math.min(0.8, 0.4 + Math.sqrt(magnitude) * 0.2);
    const rgb = mark.side === "buy" ? COLORS.bidRgb : COLORS.askRgb;
    env.under.fillStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
    env.under.fillRect(mark.x, mark.y - thickness / 2, length, thickness);
    if (index < MAX_TRADE_LABELS && magnitude >= 5) {
      env.over.fillStyle = `rgba(${rgb},0.95)`;
      env.over.fillText("$" + formatUsd(mark.usd), mark.x + length + 4, mark.y + 3);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Liquidation Hunter layers (ported from the Pine indicator)
   ═══════════════════════════════════════════════════════════════════ */

/** Estimated stop pockets: a band from the swing point out to one ATR
    buffer beyond it, drawn from where the swing formed to the right edge.
    Claims layer, so it paints under the candles. */
export function drawStopClusters(env: DrawEnv, clusters: StopCluster[],
                                 times: number[]): void {
  for (const cluster of clusters) {
    const top = env.priceToY(cluster.top);
    const bottom = env.priceToY(cluster.bottom);
    if (top === null || bottom === null) continue;
    const startTime = times[cluster.fromIndex];
    const x1 = startTime !== undefined ? env.timeToX(startTime) : null;
    const left = x1 ?? 0;
    const rgb = cluster.kind === "high" ? COLORS.askRgb : COLORS.bidRgb;
    env.under.fillStyle = `rgba(${rgb},0.10)`;
    env.under.fillRect(left, Math.min(top, bottom), env.width - left,
                       Math.max(1, Math.abs(bottom - top)));
    env.under.strokeStyle = `rgba(${rgb},0.35)`;
    env.under.lineWidth = 1;
    env.under.strokeRect(left, Math.min(top, bottom), env.width - left,
                         Math.max(1, Math.abs(bottom - top)));
  }
}

/** Sweep markers: a triangle where a stop run was pierced and rejected. */
export function drawSweeps(env: DrawEnv, marks: Sweep[]): void {
  env.over.font = "10px sans-serif";
  for (const mark of marks) {
    const x = env.timeToX(mark.time);
    const y = env.priceToY(mark.price);
    if (x === null || y === null) continue;
    const rgb = mark.kind === "bull" ? COLORS.bidRgb : COLORS.askRgb;
    const direction = mark.kind === "bull" ? 1 : -1;
    env.over.fillStyle = `rgba(${rgb},0.95)`;
    env.over.beginPath();
    env.over.moveTo(x, y - direction * 3);
    env.over.lineTo(x - 5, y - direction * 11);
    env.over.lineTo(x + 5, y - direction * 11);
    env.over.closePath();
    env.over.fill();
  }
}

/** Small diamonds/crosses for the point events. */
export function drawEventMarks(
  env: DrawEnv, marks: { time: number; price: number; kind: "bull" | "bear" }[],
  shape: "diamond" | "cross", rgbOverride?: string,
): void {
  for (const mark of marks) {
    const x = env.timeToX(mark.time);
    const y = env.priceToY(mark.price);
    if (x === null || y === null) continue;
    const rgb = rgbOverride ?? (mark.kind === "bull" ? COLORS.bidRgb : COLORS.askRgb);
    const offset = mark.kind === "bull" ? 9 : -9;
    env.over.strokeStyle = `rgba(${rgb},0.95)`;
    env.over.fillStyle = `rgba(${rgb},0.85)`;
    env.over.lineWidth = 1.5;
    env.over.beginPath();
    if (shape === "diamond") {
      env.over.moveTo(x, y + offset - 4);
      env.over.lineTo(x + 4, y + offset);
      env.over.lineTo(x, y + offset + 4);
      env.over.lineTo(x - 4, y + offset);
      env.over.closePath();
      env.over.fill();
    } else {
      env.over.moveTo(x - 4, y + offset - 4);
      env.over.lineTo(x + 4, y + offset + 4);
      env.over.moveTo(x + 4, y + offset - 4);
      env.over.lineTo(x - 4, y + offset + 4);
      env.over.stroke();
    }
  }
}

/** Dotted horizontal lines at the round numbers around price. */
export function drawRoundLevels(env: DrawEnv, levels: number[]): void {
  env.under.strokeStyle = "rgba(140,140,170,0.35)";
  env.under.lineWidth = 1;
  env.under.setLineDash([2, 4]);
  for (const level of levels) {
    const y = env.priceToY(level);
    if (y === null || y < 0 || y > env.height) continue;
    env.under.beginPath();
    env.under.moveTo(0, y);
    env.under.lineTo(env.width, y);
    env.under.stroke();
  }
  env.under.setLineDash([]);
}

/** Dashed lines at the heaviest-traded price levels. */
export function drawVolumeNodes(env: DrawEnv, levels: number[]): void {
  env.under.lineWidth = 1;
  env.under.setLineDash([6, 4]);
  levels.forEach((level, index) => {
    const y = env.priceToY(level);
    if (y === null || y < 0 || y > env.height) return;
    env.under.strokeStyle = `rgba(255,160,50,${index === 0 ? 0.55 : 0.32})`;
    env.under.beginPath();
    env.under.moveTo(0, y);
    env.under.lineTo(env.width, y);
    env.under.stroke();
  });
  env.under.setLineDash([]);
}

/** The Pine liquidation grid: leverage tiers projected off an anchor.
    Kept visually distinct from the measured liq map, because it is a
    different claim — this one assumes every position opened at the
    anchor. */
export function drawLiqGrid(env: DrawEnv, anchor: number,
                            tiers: readonly number[]): void {
  const anchorY = env.priceToY(anchor);
  if (anchorY !== null) {
    env.under.strokeStyle = "rgba(130,140,170,0.45)";
    env.under.setLineDash([4, 4]);
    env.under.beginPath();
    env.under.moveTo(0, anchorY);
    env.under.lineTo(env.width, anchorY);
    env.under.stroke();
    env.under.setLineDash([]);
  }
  for (const leverage of tiers) {
    for (const price of [anchor * (1 - 1 / leverage), anchor * (1 + 1 / leverage)]) {
      const y = env.priceToY(price);
      if (y === null || y < 0 || y > env.height) continue;
      const strong = leverage >= 50;
      env.under.strokeStyle = strong
        ? "rgba(255,80,80,0.40)" : "rgba(160,100,255,0.38)";
      env.under.lineWidth = 1;
      env.under.beginPath();
      env.under.moveTo(0, y);
      env.under.lineTo(env.width, y);
      env.under.stroke();
      env.over.font = "9px sans-serif";
      env.over.fillStyle = strong
        ? "rgba(255,110,110,0.85)" : "rgba(175,125,255,0.8)";
      env.over.fillText(`${leverage}x`, 4, y - 3);
    }
  }
}

/** POC and value-area edges, from our own executed-volume profile. */
export function drawValueArea(env: DrawEnv, poc: number | null,
                              vah: number | null, val: number | null): void {
  const band = [vah, val].map((price) => price === null ? null : env.priceToY(price));
  if (band[0] !== null && band[1] !== null) {
    env.under.fillStyle = "rgba(100,180,255,0.06)";
    env.under.fillRect(0, Math.min(band[0], band[1]), env.width,
                       Math.abs(band[1] - band[0]));
    env.under.strokeStyle = "rgba(100,180,255,0.45)";
    env.under.setLineDash([5, 4]);
    for (const y of band as number[]) {
      env.under.beginPath();
      env.under.moveTo(0, y);
      env.under.lineTo(env.width, y);
      env.under.stroke();
    }
    env.under.setLineDash([]);
  }
  if (poc === null) return;
  const y = env.priceToY(poc);
  if (y === null || y < 0 || y > env.height) return;
  env.under.strokeStyle = "rgba(255,215,0,0.75)";
  env.under.lineWidth = 2;
  env.under.beginPath();
  env.under.moveTo(0, y);
  env.under.lineTo(env.width, y);
  env.under.stroke();
  env.over.font = "10px sans-serif";
  env.over.fillStyle = "rgba(255,215,0,0.95)";
  env.over.fillText("POC", 4, y - 4);
}

/** Full-height tint for a regime that is true right now. */
export function drawRegimeTint(env: DrawEnv, rgba: string): void {
  env.under.fillStyle = rgba;
  env.under.fillRect(0, 0, env.width, env.height);
}

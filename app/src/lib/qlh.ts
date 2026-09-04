/* Quantitative Liquidation Hunter — the indicator set, ported from the
   Pine v6 script of that name.

   LICENSE OF THIS FILE: Mozilla Public License 2.0, unlike the rest of
   the repository (AGPL-3.0). The original is an open-source TradingView
   indicator, and every open-source script there is published under
   MPL-2.0; this port follows the original closely enough to be a
   derivative of it, and MPL's file-level copyleft therefore applies
   here. The copyright in the ported logic remains with the indicator's
   author. Full terms: https://www.mozilla.org/MPL/2.0/

   WHERE THIS PORT DELIBERATELY DIFFERS. Pine only has OHLCV, so several
   of the original's features are inferences from candle shape. We have
   the underlying data, and re-deriving a worse version of something we
   measure directly would be a downgrade dressed as fidelity:

     · the volume profile's buy/sell split is inferred there from
       (close-low)/range; ours is the real aggressor side off the tape,
       across nine venues, so the POC and value area come from the
       server's profile
     · cumulative delta is inferred there from candle position; we have
       real signed taker flow (the CVD layer), 14 days of it
     · the liquidation grid there is fixed percentages off a moving
       anchor, which assumes every position was opened at that anchor;
       our liq map is built from actual open-interest increases at the
       price they happened

   Everything else — stop clusters, sweeps, round-number magnets, volume
   nodes, the squeeze regime, exhaustion, volume and price z-scores — is
   computed here exactly as the original does, from candles.

   Pure module: arrays in, values out. No chart, no store, no fetch.
*/

import type { Candle } from "./types";

// ---------------------------------------------------------------- helpers

export function sma(values: number[], length: number, index: number): number | null {
  if (index < length - 1) return null;
  let total = 0;
  for (let i = index - length + 1; i <= index; i += 1) total += values[i];
  return total / length;
}

export function stdev(values: number[], length: number, index: number): number | null {
  const mean = sma(values, length, index);
  if (mean === null) return null;
  let total = 0;
  for (let i = index - length + 1; i <= index; i += 1) {
    total += (values[i] - mean) ** 2;
  }
  return Math.sqrt(total / length);
}

/** Wilder-style ATR, the `ta.atr` the original uses. */
export function atr(rows: Candle[], length = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let previous: number | null = null;
  let seed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const prevClose = i > 0 ? rows[i - 1].close : row.open;
    const trueRange = Math.max(
      row.high - row.low,
      Math.abs(row.high - prevClose),
      Math.abs(row.low - prevClose),
    );
    if (i < length) {
      seed += trueRange;
      out.push(i === length - 1 ? (previous = seed / length) : null);
    } else {
      previous = ((previous as number) * (length - 1) + trueRange) / length;
      out.push(previous);
    }
  }
  return out;
}

export function rsi(closes: number[], length = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const up = Math.max(change, 0);
    const down = Math.max(-change, 0);
    if (i <= length) {
      gain += up;
      loss += down;
      if (i === length) {
        gain /= length;
        loss /= length;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
      continue;
    }
    gain = (gain * (length - 1) + up) / length;
    loss = (loss * (length - 1) + down) / length;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// ------------------------------------------------------------- structure

export interface Pivot {
  index: number;
  price: number;
  kind: "high" | "low";
}

/** Confirmed swing points: a bar whose high (low) is the most extreme
    across `left` bars before and `right` bars after. The `right` bars are
    why a pivot is only known some bars later — that lag is real, not a
    bug, and the original carries it too. */
export function pivots(rows: Candle[], left: number, right: number): Pivot[] {
  const found: Pivot[] = [];
  for (let i = left; i < rows.length - right; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (rows[j].high >= rows[i].high) isHigh = false;
      if (rows[j].low <= rows[i].low) isLow = false;
    }
    if (isHigh) found.push({ index: i, price: rows[i].high, kind: "high" });
    if (isLow) found.push({ index: i, price: rows[i].low, kind: "low" });
  }
  return found;
}

export interface StopCluster {
  kind: "high" | "low";
  /** Zone edges: the pivot itself, and one ATR-buffer beyond it. */
  top: number;
  bottom: number;
  fromIndex: number;
  pivotPrice: number;
}

/** Where stops most likely rest: just beyond a swing point.

    Not the same thing as the liquidation map. Liquidations are forced by
    an exchange at a leverage-determined price; these are voluntary stop
    orders a crowd places just past an obvious level. Both are fuel, from
    different tanks. A cluster is dropped once price closes decisively
    through it — it has been spent. */
export function stopClusters(
  rows: Candle[], left: number, right: number, bufferAtr: number, max: number,
): StopCluster[] {
  const atrValues = atr(rows);
  const clusters: StopCluster[] = [];
  for (const pivot of pivots(rows, left, right)) {
    const buffer = (atrValues[pivot.index] ?? 0) * bufferAtr;
    if (buffer <= 0) continue;
    clusters.push(pivot.kind === "high"
      ? { kind: "high", top: pivot.price + buffer, bottom: pivot.price,
          fromIndex: pivot.index, pivotPrice: pivot.price }
      : { kind: "low", top: pivot.price, bottom: pivot.price - buffer,
          fromIndex: pivot.index, pivotPrice: pivot.price });
  }
  // Drop clusters price has closed decisively beyond (twice the buffer),
  // matching the original's invalidation rule.
  const last = rows[rows.length - 1];
  const lastAtr = atrValues[rows.length - 1] ?? 0;
  const spent = clusters.filter((cluster) => {
    const beyond = lastAtr * bufferAtr * 2;
    return cluster.kind === "high"
      ? last.close <= cluster.pivotPrice + beyond
      : last.close >= cluster.pivotPrice - beyond;
  });
  return spent.slice(-max * 2);
}

export interface Sweep {
  index: number;
  time: number;
  kind: "bull" | "bear";
  price: number;
}

/** A stop run that failed: price pierces a cluster, then closes back
    outside it, leaving a long wick. Optionally requires the bar's volume
    to be anomalous, which is the original's `Require Volume Confirm`. */
export function sweeps(
  rows: Candle[], clusters: StopCluster[], minWickRatio: number,
  requireVolume: boolean, volumeZ: (number | null)[],
): Sweep[] {
  const out: Sweep[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const range = row.high - row.low;
    if (range <= 0) continue;
    const upperWick = (row.high - Math.max(row.open, row.close)) / range;
    const lowerWick = (Math.min(row.open, row.close) - row.low) / range;
    const volumeOk = !requireVolume || (volumeZ[i] ?? 0) > 0;
    if (!volumeOk) continue;
    for (const cluster of clusters) {
      if (cluster.fromIndex >= i) continue; // a cluster cannot be swept before it forms
      if (cluster.kind === "high" && row.high >= cluster.pivotPrice
          && row.close < cluster.pivotPrice && upperWick >= minWickRatio) {
        out.push({ index: i, time: row.time, kind: "bear", price: row.high });
        break;
      }
      if (cluster.kind === "low" && row.low <= cluster.pivotPrice
          && row.close > cluster.pivotPrice && lowerWick >= minWickRatio) {
        out.push({ index: i, time: row.time, kind: "bull", price: row.low });
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- volume

/** Volume z-score per bar over `length`. Null until there is enough. */
export function volumeZScores(rows: Candle[], length: number): (number | null)[] {
  const volumes = rows.map((row) => row.volume ?? 0);
  return volumes.map((value, index) => {
    const mean = sma(volumes, length, index);
    const deviation = stdev(volumes, length, index);
    if (mean === null || deviation === null || deviation === 0) return null;
    return (value - mean) / deviation;
  });
}

export function priceZScores(rows: Candle[], length = 50): (number | null)[] {
  const closes = rows.map((row) => row.close);
  return closes.map((value, index) => {
    const mean = sma(closes, length, index);
    const deviation = stdev(closes, length, index);
    if (mean === null || deviation === null || deviation === 0) return null;
    return (value - mean) / deviation;
  });
}

export interface Absorption {
  index: number;
  time: number;
  kind: "bull" | "bear";
  price: number;
}

/** Heavy volume that went nowhere: someone sat on it.

    Volume above the mean, a body small relative to the bar's range, and a
    range worth noticing. The wick that dominates says which side did the
    absorbing. */
export function absorptions(
  rows: Candle[], volumeZ: (number | null)[], maxBodyRatio: number,
): Absorption[] {
  const atrValues = atr(rows);
  const out: Absorption[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const range = row.high - row.low;
    const atrValue = atrValues[i];
    if (range <= 0 || atrValue === null) continue;
    const bodyRatio = Math.abs(row.close - row.open) / range;
    if ((volumeZ[i] ?? 0) <= 1 || bodyRatio >= maxBodyRatio) continue;
    if (range <= atrValue * 0.4) continue;
    const upperWick = row.high - Math.max(row.open, row.close);
    const lowerWick = Math.min(row.open, row.close) - row.low;
    out.push({
      index: i, time: row.time,
      kind: lowerWick > upperWick ? "bull" : "bear",
      price: lowerWick > upperWick ? row.low : row.high,
    });
  }
  return out;
}

/** The `count` bars of heaviest volume in the lookback, as price levels
    (typical price). The original's "high-volume nodes". */
export function volumeNodes(rows: Candle[], lookback: number, count: number): number[] {
  const window = rows.slice(-lookback);
  return window
    .map((row) => ({ volume: row.volume ?? 0,
                     price: (row.high + row.low + row.close) / 3 }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, count)
    .map((entry) => entry.price);
}

// ------------------------------------------------------------- volatility

export interface SqueezeState {
  index: number;
  time: number;
  on: boolean;
  fired: boolean;
  easy: boolean;
  momentum: number;
}

/** Bollinger-inside-Keltner compression, and its release.

    Squeeze ON means range has contracted — the market is coiled. The
    FIRE bar is the one where it stops being true, which is the part
    people trade. "Easy move" is the softer version: bands merely near
    the channel rather than inside it. */
export function squeeze(
  rows: Candle[], bbLength: number, kcLength: number, kcMult: number,
  easyRatio: number,
): SqueezeState[] {
  const closes = rows.map((row) => row.close);
  const atrValues = atr(rows, kcLength);
  const out: SqueezeState[] = [];
  let previousOn = false;
  for (let i = 0; i < rows.length; i += 1) {
    const basis = sma(closes, bbLength, i);
    const deviation = stdev(closes, bbLength, i);
    const kcBasis = sma(closes, kcLength, i);
    const range = atrValues[i];
    if (basis === null || deviation === null || kcBasis === null || range === null) {
      out.push({ index: i, time: rows[i].time, on: false, fired: false,
                 easy: false, momentum: 0 });
      continue;
    }
    const bbWidth = 4 * deviation;             // (basis+2σ) − (basis−2σ)
    const kcWidth = 2 * kcMult * range;
    const on = bbWidth < kcWidth;
    out.push({
      index: i, time: rows[i].time, on,
      fired: previousOn && !on,
      easy: kcWidth > 0 && bbWidth / kcWidth <= easyRatio,
      momentum: closes[i] - basis,
    });
    previousOn = on;
  }
  return out;
}

// -------------------------------------------------------------- momentum

export interface Exhaustion {
  index: number;
  time: number;
  kind: "bull" | "bear";
  price: number;
}

/** A push that is running out of fuel: a fresh extreme, momentum
    decelerating two bars running, and RSI refusing to confirm. */
export function exhaustions(
  rows: Candle[], rsiLength: number, rocLength: number,
): Exhaustion[] {
  const closes = rows.map((row) => row.close);
  const rsiValues = rsi(closes, rsiLength);
  const roc = closes.map((value, index) =>
    index < rocLength ? null
      : (value - closes[index - rocLength]) / closes[index - rocLength] * 100);
  const out: Exhaustion[] = [];
  for (let i = Math.max(rocLength + 2, 11); i < rows.length; i += 1) {
    const current = rsiValues[i];
    const past = rsiValues[i - 3];
    if (current === null || past === null) continue;
    const a = roc[i];
    const b = roc[i - 1];
    const c = roc[i - 2];
    if (a === null || b === null || c === null) continue;
    const decelerating = Math.abs(a) < Math.abs(b) && Math.abs(b) < Math.abs(c);
    if (!decelerating) continue;
    const priorHigh = Math.max(...rows.slice(i - 10, i).map((row) => row.high));
    const priorLow = Math.min(...rows.slice(i - 10, i).map((row) => row.low));
    if (rows[i].high > priorHigh && current < past && current > 60) {
      out.push({ index: i, time: rows[i].time, kind: "bear", price: rows[i].high });
    } else if (rows[i].low < priorLow && current > past && current < 40) {
      out.push({ index: i, time: rows[i].time, kind: "bull", price: rows[i].low });
    }
  }
  return out;
}

// --------------------------------------------------------- round numbers

/** The price levels a crowd fixates on: the nearest "nice" numbers above
    and below, spaced by one tenth of the price's own magnitude. */
export function roundLevels(price: number, count = 2): number[] {
  if (!(price > 0)) return [];
  const magnitude = 10 ** Math.floor(Math.log10(price));
  const step = magnitude / 10;
  const base = Math.floor(price / step) * step;
  const levels: number[] = [];
  for (let i = -count + 1; i <= count; i += 1) levels.push(base + i * step);
  return levels.filter((level) => level > 0);
}

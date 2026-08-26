/* Pure candle math: style transforms and moving averages. No chart, no
   fetch, no store — everything here is testable with plain arrays. */

import type { ChartStyle, MaDef } from "./config";
import type { Candle } from "./types";

export interface LinePoint {
  time: number;
  value: number;
}

/** Standard Heikin-Ashi recursion: HA-close = OHLC/4, HA-open = midpoint of
    the previous HA candle (seeded from the first row's own open/close). */
export function toHeikinAshi(rows: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen: number | null = null;
  let prevClose = 0;
  for (const row of rows) {
    const close = (row.open + row.high + row.low + row.close) / 4;
    // Explicit annotation: TS's narrowing of prevOpen otherwise forms an
    // inference cycle (open → prevOpen → open) and errors with TS7022.
    const open: number = prevOpen === null ? (row.open + row.close) / 2
                                           : (prevOpen + prevClose) / 2;
    out.push({
      time: row.time,
      open,
      high: Math.max(row.high, open, close),
      low: Math.min(row.low, open, close),
      close,
    });
    prevOpen = open;
    prevClose = close;
  }
  return out;
}

/** Rows shaped for the active price-series type: OHLC styles pass through
    (heikin transformed), line/area collapse to close values. */
export function styledRows(rows: Candle[], style: ChartStyle): Candle[] | LinePoint[] {
  if (style === "heikin") return toHeikinAshi(rows);
  if (style === "line" || style === "area") {
    return rows.map((row) => ({ time: row.time, value: row.close }));
  }
  return rows;
}

/** Simple moving average over closes; first point lands at index length-1. */
export function computeSma(rows: Candle[], length: number): LinePoint[] {
  const points: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].close;
    if (i >= length) sum -= rows[i - length].close;
    if (i >= length - 1) points.push({ time: rows[i].time, value: sum / length });
  }
  return points;
}

/** Exponential moving average (k = 2/(n+1)), seeded from the first close;
    points emitted from index length-1 so the warm-up is not drawn. */
export function computeEma(rows: Candle[], length: number): LinePoint[] {
  const points: LinePoint[] = [];
  const k = 2 / (length + 1);
  let ema: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    ema = ema === null ? rows[i].close : rows[i].close * k + ema * (1 - k);
    if (i >= length - 1) points.push({ time: rows[i].time, value: ema });
  }
  return points;
}

export function computeMa(rows: Candle[], def: MaDef): LinePoint[] {
  return def.kind === "sma" ? computeSma(rows, def.length)
                            : computeEma(rows, def.length);
}


/** Union of two candle sets keyed by bar time, `incoming` winning on
    overlap (a poll's fresh forming bar replaces its stale copy), sorted
    ascending. Powers both the 15s poll (latest window merged onto kept
    history) and pan-left backfill (older page merged underneath). */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const row of existing) byTime.set(row.time, row);
  for (const row of incoming) byTime.set(row.time, row);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Snap a time series onto the chart's bar boundaries, last value per bar.

    Lightweight Charts gives every series a slot on ONE shared time axis,
    so a line carrying minute-resolution points puts a slot on the axis
    for every minute — and on an hourly chart the candles get pushed apart
    to make room for them, which reads as huge gaps between candles
    (Arash, 2026-08-27, after CVD grew to 14 days and the positioning line
    landed). Bucketing to the displayed interval keeps every series on the
    candles' own timestamps, so the axis has exactly one slot per bar.

    `points` must be time-ascending, which both CVD and positioning are. */
export function bucketSeries(
  points: readonly (readonly [number, number])[], bucketSeconds: number,
): { time: number; value: number }[] {
  if (bucketSeconds <= 1) return points.map(([time, value]) => ({ time, value }));
  const out: { time: number; value: number }[] = [];
  for (const [ts, value] of points) {
    const bucket = Math.floor(ts / bucketSeconds) * bucketSeconds;
    const last = out[out.length - 1];
    if (last !== undefined && last.time === bucket) last.value = value;
    else out.push({ time: bucket, value });
  }
  return out;
}

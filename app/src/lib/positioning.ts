/* Choosing which positioning series to draw.

   Coverage differs per symbol — Binance ratios exist only for the five
   Binance-listed symbols, the Bitfinex margin book only where Bitfinex
   runs one, and the equity perps have neither. So the chart asks for a
   metric and takes the best available instead of drawing a blank line. */

import { POSITIONING_METRICS } from "./config";
import type { PositioningSeries } from "./types";

/** The metric to draw: the requested one when it has data, otherwise the
    first available in preference order (money-weighted before the real
    margin book before account-count sentiment). Null when the symbol has
    no positioning data at all — most stocks, and any HL-only coin. */
export function pickPositioningMetric(
  series: PositioningSeries, preferred: string,
): string | null {
  const hasData = (key: string) => (series[key]?.length ?? 0) > 0;
  if (preferred && hasData(preferred)) return preferred;
  return POSITIONING_METRICS.find(hasData) ?? null;
}

/** Metrics the symbol actually has, in preference order — what the
    selector should offer. */
export function availableMetrics(series: PositioningSeries): string[] {
  return POSITIONING_METRICS.filter((key) => (series[key]?.length ?? 0) > 0);
}

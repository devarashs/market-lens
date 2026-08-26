/* Tape rows: identity, display strings, and burst batching.

   Three problems this solves, all measured on the live page (2026-08-27).

   IDENTITY. Rows were keyed `ts-price-size`, which collides whenever one
   order fills as several prints in the same millisecond at the same price
   — ordinary market behaviour, and ~1% of BTC prints in the archive.
   React cannot match colliding keys across renders, so it appended
   another copy each time instead of reusing the node: the panel held 523
   <li> for 121 distinct trades, three of them duplicated 120 times, and
   the count climbed the whole time it was watched. That unbounded DOM is
   what made the tape feel laggy — throughput never exceeded ~5
   messages/second. Every row now carries a client-side sequence number,
   unique by construction rather than by hoping the data never repeats.

   RENDER COST. `toLocaleString` on every row on every render was ~0.8ms
   of the ~1ms each render spent formatting. Those strings depend only on
   the print, so they are computed once, when it arrives.

   BURSTS. Prints arrive in clumps. Applying each one to the store meant a
   React render per print; they are buffered and flushed once per frame,
   so a burst costs one render.
*/

import { formatUsd, formatUtcTime } from "./format";
import type { LiqEvent, Trade } from "./types";

let sequence = 0;

interface Decorated {
  /** Client-side, monotonic — the React key. Never derived from the data. */
  id: number;
  usdText: string;
  priceText: string;
  timeText: string;
}

export type TradeItem = Trade & Decorated;
export type LiqItem = LiqEvent & Decorated;

function decoration(ts: number, price: number, notional: number): Decorated {
  return {
    id: (sequence += 1),
    usdText: formatUsd(notional),
    priceText: price.toLocaleString(),
    timeText: formatUtcTime(ts),
  };
}

export const asTradeItem = (trade: Trade): TradeItem =>
  ({ ...trade, ...decoration(trade.ts, trade.price, trade.notional) });

export const asLiqItem = (liq: LiqEvent): LiqItem =>
  ({ ...liq, ...decoration(liq.ts, liq.price, liq.notional) });

/** Append `incoming`, keeping at most `cap`. Returns the SAME array when
    nothing is added, so React can skip the render entirely. */
export function appendCapped<T>(existing: T[], incoming: T[], cap: number): T[] {
  if (incoming.length === 0) return existing;
  const merged = existing.concat(incoming);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Row tint deepens with size: a print at the threshold sits near 12%, a
    monster saturates toward 50% — the tape's weight readable by colour. */
export function tintPercent(magnitude: number): number {
  if (!(magnitude > 0)) return 12;
  return Math.min(50, 12 + Math.sqrt(magnitude) * 9);
}

export type TapeRow =
  | { kind: "trade"; item: TradeItem }
  | { kind: "liq"; item: LiqItem };

/** The rows to show: both kinds interleaved by time, newest first, gated
    by threshold, venue and symbol.

    Merges the two already-time-ordered lists from their newest ends and
    stops once `limit` rows are found, so the cost is bounded by what is
    displayed rather than by how much history is held. */
export function visibleRows(
  trades: TradeItem[], liqs: LiqItem[], threshold: number,
  activeVenues: string[] | null, symbol: string, limit: number,
): TapeRow[] {
  const keep = (item: { notional: number; venue: string; symbol?: string }) =>
    item.notional >= threshold
    && (activeVenues === null || activeVenues.includes(item.venue))
    && (item.symbol === undefined || item.symbol === symbol);

  const rows: TapeRow[] = [];
  let t = trades.length - 1;
  let l = liqs.length - 1;
  while (rows.length < limit && (t >= 0 || l >= 0)) {
    const trade = t >= 0 ? trades[t] : null;
    const liq = l >= 0 ? liqs[l] : null;
    const takeTrade = trade !== null && (liq === null || trade.ts >= liq.ts);
    if (takeTrade) {
      if (keep(trade!)) rows.push({ kind: "trade", item: trade! });
      t -= 1;
    } else {
      if (keep(liq!)) rows.push({ kind: "liq", item: liq! });
      l -= 1;
    }
  }
  return rows;
}

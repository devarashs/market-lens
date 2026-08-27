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

/** Size band for a row, 0..2 — the aggr.trade idea, adopted 2026-08-27
    ("colors a bit more sharp").

    A continuous tint made every row look the same washed-out shade,
    because even a monster only reached 50% opacity over a dark surface.
    Discrete bands let the big prints go fully saturated with white text
    while small ones stay quiet, so size is legible at a glance instead of
    requiring a careful look. Type size and weight follow the same band in
    CSS, which is most of why aggr's tape reads so well. */
export function sizeLevel(magnitude: number): 0 | 1 | 2 {
  if (!(magnitude > 0)) return 0;
  if (magnitude >= 5) return 2;    // "monster" — matches the chart's label
  if (magnitude >= 2) return 1;
  return 0;
}

/** Gate shared by both lists: threshold, venue filter and symbol. */
function passes(
  item: { notional: number; venue: string; symbol?: string },
  threshold: number, activeVenues: string[] | null, symbol: string,
): boolean {
  return item.notional >= threshold
    && (activeVenues === null || activeVenues.includes(item.venue))
    && (item.symbol === undefined || item.symbol === symbol);
}

/** Newest-first trades only.

    Liquidations used to be interleaved into this list. They are a
    different kind of event — forced, non-discretionary — and mixing them
    into the flow made both harder to read (Arash: "lets not mix them
    up"), so they now have their own strip and their own reader below. */
export function tradeRows(
  trades: TradeItem[], threshold: number,
  activeVenues: string[] | null, symbol: string, limit: number,
): TradeItem[] {
  const rows: TradeItem[] = [];
  for (let i = trades.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    if (passes(trades[i], threshold, activeVenues, symbol)) rows.push(trades[i]);
  }
  return rows;
}

/** Newest-first liquidations, for the strip under the tape. Deliberately
    NOT gated on the big-trade threshold: a forced exit is worth seeing at
    any size, and the strip is short enough that it cannot flood. */
export function liqRows(
  liqs: LiqItem[], activeVenues: string[] | null, symbol: string, limit: number,
): LiqItem[] {
  const rows: LiqItem[] = [];
  for (let i = liqs.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    if (passes(liqs[i], 0, activeVenues, symbol)) rows.push(liqs[i]);
  }
  return rows;
}

/** Long/short notional over the rows shown, for the strip's header —
    "who is being forced out right now" in one line. */
export function liqTotals(rows: LiqItem[]): { long: number; short: number } {
  let long = 0;
  let short = 0;
  for (const row of rows) {
    if (row.side === "long") long += row.notional;
    else short += row.notional;
  }
  return { long, short };
}

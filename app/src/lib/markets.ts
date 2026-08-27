/* Watchlist rows: one per MARKET (exchange × symbol), sorted and filtered.

   Sorting is here rather than in the component so it can be tested without
   a DOM, and because the null handling is the part that is easy to get
   wrong: a market with no price yet must not win a "highest price" sort by
   accident. Unknown values sink to the bottom in BOTH directions. */

export type SortMode = "none" | "price" | "volume" | "delta" | "change";

export const SORT_MODES: readonly SortMode[] = [
  "none", "volume", "delta", "change", "price",
] as const;

export interface MarketRow {
  symbol: string;
  venue: string;
  price: number | null;
  change: number | null;   // 24h, per SYMBOL (see MarketsPage note)
  volume: number;          // 24h taker notional on this market
  delta: number;           // 24h buy − sell, in dollars
  deltaPct: number | null; // delta as a share of this market's own volume
}

export interface MarketsResponse {
  asOf: number;
  windowHours: number;
  bucketSeconds: number;
  seedMs: number | null;
  markets: MarketRow[];
}

function value(row: MarketRow, mode: SortMode): number | null {
  switch (mode) {
    case "price": return row.price;
    case "volume": return row.volume;
    case "delta": return row.deltaPct;
    case "change": return row.change;
    default: return null;
  }
}

/** Sort a copy. "none" keeps the server's order, which is volume-descending
    — the ordering that makes the list readable before you touch anything. */
export function sortMarkets(
  rows: MarketRow[], mode: SortMode, descending: boolean,
): MarketRow[] {
  if (mode === "none") return rows.slice();
  const direction = descending ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const left = value(a, mode);
    const right = value(b, mode);
    // Unknown sinks either way: "no price yet" is not the highest price.
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction;
  });
}

/** Volume floor + free-text match on symbol or venue.

    The floor matters more than it looks. deltaPct is normalised by each
    market's own volume, so sorting by it ranks ONE-SIDEDNESS, not size: a
    market that traded $21k almost entirely one way outranks one that
    traded $183M with $22M of net buying behind it. Raising the floor is
    how you make that ranking mean something. */
export function filterMarkets(
  rows: MarketRow[], minVolume: number, query: string,
): MarketRow[] {
  const q = query.trim().toUpperCase();
  return rows.filter((row) =>
    row.volume >= minVolume
    && (q === ""
      || row.symbol.toUpperCase().includes(q)
      || row.venue.toUpperCase().includes(q)));
}

/** Totals across whatever is currently shown, for the page header. */
export function summarise(rows: MarketRow[]): {
  markets: number; volume: number; delta: number; deltaPct: number | null;
} {
  let volume = 0;
  let delta = 0;
  for (const row of rows) {
    volume += row.volume;
    delta += row.delta;
  }
  return {
    markets: rows.length,
    volume,
    delta,
    deltaPct: volume > 0 ? (delta / volume) * 100 : null,
  };
}

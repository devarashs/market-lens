/* Spread arithmetic for a book aggregated across venues.

   The ladder sums nine venues, spot and perpetual futures together. So
   "best bid" and "best ask" in the aggregate routinely come from two
   different instruments, and perps trade at a basis to spot. Whenever
   that basis is wider than either venue's own spread, the aggregate
   CROSSES: the highest bid sits above the lowest ask.

   Verified live on BTC, 2026-08-27 — kraken 80,333.4 / 80,333.5 (spot)
   against binance-fut 80,274.4 / 80,274.5 (perp). Every venue tight, not
   one of them crossed, and the aggregate crossed by ~7bp. Subtracting
   across the aggregate there produced "-10.0bp" in the UI, which is not
   a spread at all: it is the basis with a minus sign in front of it.

   So nothing here subtracts across venues and calls the result a spread.
   Two separate, honestly-named numbers come out instead:

     tightestVenueSpread   a real, executable spread, from ONE venue
     crossVenueBasis       the overlap, when the aggregate crosses,
                           named for what it actually is

   plus overlapBand, which tells the ladder which rows sit in the region
   where the two sides occupy the same prices.

   docs-content.ts "reading-composite" is the user-facing statement of the
   same thing. The two are meant to agree; change them together. */

import type { DepthLevel } from "./types";

/** Per-venue top of book, exactly as a depth frame's `best` carries it.
    The server builds it from the client's ACTIVE venue filter, so
    filtering Markets down to one venue narrows everything below. */
export type VenueBest = Record<string, { bid: number | null; ask: number | null }>;

/** One venue's own spread. `bps` is always >= 0 — see venueSpreads. */
export interface VenueSpread {
  venue: string;
  /** (ask - bid) over that venue's OWN mid, in basis points. */
  bps: number;
  bid: number;
  ask: number;
}

/** The overlap between two venues when the aggregated book crosses. */
export interface CrossVenueBasis {
  /** Positive magnitude of the overlap, in basis points. */
  bps: number;
  /** Venue holding the highest bid. */
  bidVenue: string;
  /** Venue holding the lowest ask. */
  askVenue: string;
  bid: number;
  ask: number;
}

/** The price region where the ladder's two sides overlap, inclusive. */
export interface OverlapBand {
  /** Lowest ask bin present. */
  low: number;
  /** Highest bid bin present. */
  high: number;
}

/** A price is usable only if it is a finite positive number. Venues appear
    in `best` with a null side while their book is still warming up, and a
    zero would poison every ratio below. */
function isQuotePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Every venue's own spread, tightest first.
 *
 * Denominated in each venue's OWN mid rather than the aggregate mid: this
 * is a single-venue measurement, and it must not drift when some other
 * venue's basis moves.
 *
 * A venue quoting its ask below its own bid is skipped. One book cannot
 * genuinely be crossed; it means a stale or garbled feed, and letting it
 * through would hand "tightest" to the most broken venue on the list —
 * precisely the failure this module exists to prevent.
 *
 * Ties break on venue name so a rendered label holds still from frame to
 * frame. Exact ties are real here rather than theoretical: a locked venue
 * quoting bid == ask scores 0bp (coinbase did, in the sample above), and
 * more than one venue can be locked at the same moment.
 */
export function venueSpreads(best: VenueBest | null | undefined): VenueSpread[] {
  const spreads: VenueSpread[] = [];
  for (const [venue, quote] of Object.entries(best ?? {})) {
    const bid = quote?.bid;
    const ask = quote?.ask;
    if (!isQuotePrice(bid) || !isQuotePrice(ask)) continue;
    if (ask < bid) continue;
    spreads.push({ venue, bps: ((ask - bid) / ((ask + bid) / 2)) * 10_000, bid, ask });
  }
  return spreads.sort((a, b) => a.bps - b.bps || (a.venue < b.venue ? -1 : 1));
}

/**
 * The tightest real spread on offer, or null when no venue is quoting both
 * sides. This is the number to show anyone asking "what is the spread?":
 * it is executable at one venue, unlike anything derived from the
 * aggregate.
 */
export function tightestVenueSpread(best: VenueBest | null | undefined): VenueSpread | null {
  return venueSpreads(best)[0] ?? null;
}

/** Best quote on one side across all venues: the highest bid, or the
    lowest ask. Ties break on venue name, for the same stability reason as
    venueSpreads. Null when nobody is quoting that side. */
function extremeQuote(
  best: VenueBest | null | undefined, side: "bid" | "ask",
): { venue: string; price: number } | null {
  let found: { venue: string; price: number } | null = null;
  for (const [venue, quote] of Object.entries(best ?? {})) {
    const price = quote?.[side];
    if (!isQuotePrice(price)) continue;
    if (found === null
      || (side === "bid" ? price > found.price : price < found.price)
      || (price === found.price && venue < found.venue)) {
      found = { venue, price };
    }
  }
  return found;
}

/**
 * The basis exposed when the aggregated book crosses — the highest bid
 * across venues sitting ABOVE the lowest ask across venues.
 *
 * Null when the venues agree and the two sides merely touch or separate,
 * which is the ordinary case. Also null when one venue holds both
 * extremes: that is a single crossed book, a feed fault, not a basis
 * between two instruments, and it must not be labelled as one.
 *
 * NOT free money, and not a signal. Crossing it means two instruments,
 * two fee schedules, funding, and inventory in two places. It is reported
 * so that the number already on screen has an honest name.
 */
export function crossVenueBasis(best: VenueBest | null | undefined): CrossVenueBasis | null {
  const highBid = extremeQuote(best, "bid");
  const lowAsk = extremeQuote(best, "ask");
  if (!highBid || !lowAsk) return null;
  if (highBid.venue === lowAsk.venue) return null;
  const overlap = highBid.price - lowAsk.price;
  if (overlap <= 0) return null;
  return {
    bps: (overlap / ((highBid.price + lowAsk.price) / 2)) * 10_000,
    bidVenue: highBid.venue,
    askVenue: lowAsk.venue,
    bid: highBid.price,
    ask: lowAsk.price,
  };
}

/**
 * The venue whose own mid sits furthest from the aggregate mid, in basis
 * points, signed — positive means that venue quotes above the consensus.
 *
 * Deliberately measured against the AGGREGATE mid, unlike venueSpreads:
 * the question here is "who disagrees with everyone else, and by how
 * much", which has no meaning venue-locally. Null when the aggregate mid
 * is unusable or no venue is quoting both sides.
 */
export function widestVenueDivergence(
  best: VenueBest | null | undefined, aggregateMid: number | null | undefined,
): { venue: string; bps: number } | null {
  if (!isQuotePrice(aggregateMid)) return null;
  let widest: { venue: string; bps: number } | null = null;
  for (const { venue, bid, ask } of venueSpreads(best)) {
    const bps = (((bid + ask) / 2 - aggregateMid) / aggregateMid) * 10_000;
    if (widest === null
      || Math.abs(bps) > Math.abs(widest.bps)
      || (Math.abs(bps) === Math.abs(widest.bps) && venue < widest.venue)) {
      widest = { venue, bps };
    }
  }
  return widest;
}

/** Highest or lowest price present on one side of the binned ladder.
    Scanned rather than read from index 0: overlapBand is a claim about the
    whole book, and it should not quietly change meaning if the server's
    level ordering ever does. */
function extremeLevel(
  levels: readonly DepthLevel[] | null | undefined, pick: "max" | "min",
): number | null {
  let found: number | null = null;
  for (const level of levels ?? []) {
    const price = level?.[0];
    if (!isQuotePrice(price)) continue;
    if (found === null || (pick === "max" ? price > found : price < found)) found = price;
  }
  return found;
}

/**
 * The price band where the aggregated ladder's two sides overlap, or null
 * when they do not meet at all.
 *
 * Inclusive at both ends, and a locked aggregate (highest bid exactly
 * equal to lowest ask) counts: the ladder does print that price on both
 * sides, which is the thing worth marking.
 *
 * Rows inside this band are not wrong and are never removed — showing
 * where size rests across all nine venues is the entire point of the
 * aggregate. They only need marking, because a bid printed above an ask
 * reads as a bug to anyone who has not been told why it is not one.
 */
export function overlapBand(
  bids: readonly DepthLevel[] | null | undefined,
  asks: readonly DepthLevel[] | null | undefined,
): OverlapBand | null {
  const highestBid = extremeLevel(bids, "max");
  const lowestAsk = extremeLevel(asks, "min");
  if (highestBid === null || lowestAsk === null) return null;
  if (highestBid < lowestAsk) return null;
  return { low: lowestAsk, high: highestBid };
}

/** Whether a ladder row sits inside the overlap band. Deliberately
    side-agnostic: inside the band an ask row is below some bid and a bid
    row is above some ask, so both want the same mark. */
export function isInOverlap(price: number, band: OverlapBand | null): boolean {
  return band !== null && price >= band.low && price <= band.high;
}

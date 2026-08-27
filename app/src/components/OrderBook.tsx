/* DOM-style orderbook ladder (the Tealstreet/Insilico look Arash asked
   for): asks stacked above, bids below, per-row size + cumulative +
   price with a depth bar behind each row scaled by cumulative share.
   The middle row shows the last trade price (colored by aggressor side)
   and, on the right, the spread readout — a real single-venue spread,
   plus the cross-venue basis when the aggregate crosses. The "grp"
   select is the price-compression control: absolute bin sizes drawn from
   the server's own ladder, which is scaled to the symbol's price, so the
   options offered are exactly the ones the server will honour. */

import { formatBin } from "../lib/grouping";
import { formatBps, formatUsd, shortVenue } from "../lib/format";
import {
  crossVenueBasis, isInOverlap, overlapBand, venueSpreads,
} from "../lib/spread";
import type { VenueBest } from "../lib/spread";
import { useLensStore } from "../store/lens";

const LADDER_ROWS = 11; // per side — fits the panel without scrolling

/* Shown on every row inside the overlap band. Those rows are marked and
   never dropped: the size resting there is real across all nine venues,
   and only the ordering is an artifact of summing spot and perps. */
const OVERLAP_HINT =
  "Bid and ask bins overlap at these prices. The aggregate sums spot and perp "
  + "venues, which trade at a basis to each other, so near the touch both sides "
  + "can occupy the same prices. The resting size is real — only the ordering "
  + "is an artifact of aggregating.";

interface Row {
  price: number;
  sizeUsd: number;
  cumUsd: number;
}

function ladder(levels: [number, number][]): Row[] {
  const rows: Row[] = [];
  let cum = 0;
  for (const [price, sizeUsd] of levels.slice(0, LADDER_ROWS)) {
    cum += sizeUsd;
    rows.push({ price, sizeUsd, cumUsd: cum });
  }
  return rows;
}

/**
 * The middle row's right-hand readout: two separately-named numbers, never
 * one.
 *
 * The aggregate's own top of book is not a tradeable book, so subtracting
 * across it yields a "spread" that goes negative whenever the spot/perp
 * basis is wider than any single venue's spread — it rendered "-10.0bp" on
 * BTC, 2026-08-27. A spread therefore comes from ONE venue and is labelled
 * with it, and the crossing is reported separately as basis, which is what
 * it actually is. lib/spread.ts holds the arithmetic and the reading.
 *
 * Presentational: takes the frame's `best` map, reads no store.
 */
function SpreadReadout({ best }: { best: VenueBest | undefined }) {
  const spreads = venueSpreads(best);
  const tightest = spreads[0];
  const basis = crossVenueBasis(best);
  if (!tightest && !basis) return null;

  return (
    <span className="ladder-spread">
      {tightest && (
        <span
          title={"Tightest single-venue spread — the only executable one.\n\n"
            + spreads.map((s) => `${s.venue}  ${formatBps(s.bps)}`).join("\n")}
        >
          {formatBps(tightest.bps)} {shortVenue(tightest.venue)}
        </span>
      )}
      {basis && (
        <span
          className="basis"
          title={`The aggregated book crosses: ${basis.bidVenue} bids `
            + `${basis.bid.toLocaleString("en-US")} while ${basis.askVenue} asks `
            + `${basis.ask.toLocaleString("en-US")}. Spot and perps trade at a `
            + "basis to each other, and that gap is what this is — not a spread, "
            + "and not free money: crossing it means two instruments, two fee "
            + "schedules, funding, and inventory in two places."}
        >
          {formatBps(basis.bps)} basis
        </span>
      )}
    </span>
  );
}

export function OrderBook() {
  const depth = useLensStore((s) => s.depth);
  const trades = useLensStore((s) => s.trades);
  const symbol = useLensStore((s) => s.symbol);
  const setBinSize = useLensStore((s) => s.setBinSize);

  if (!depth) {
    return (
      <>
        <h2>Orderbook</h2>
        <p className="muted">book warming up…</p>
      </>
    );
  }

  const bids = ladder(depth.bids); // nearest-mid first, walking down
  const asks = ladder(depth.asks); // nearest-mid first, walking up
  const maxCum = Math.max(
    bids[bids.length - 1]?.cumUsd ?? 0, asks[asks.length - 1]?.cumUsd ?? 0, 1);
  const lastTrade = trades[trades.length - 1];
  // Where the two sides occupy the same prices. Taken from the whole frame
  // rather than the rendered slice, so the band stays a fact about the book
  // and not about how many rows happen to fit the panel.
  const band = overlapBand(depth.bids, depth.asks);
  const decimals = depth.bin >= 1 ? 0 : Math.min(6, -Math.floor(Math.log10(depth.bin)));

  const row = (entry: Row, side: "bid" | "ask") => {
    const crossed = isInOverlap(entry.price, band);
    return (
      <div
        key={`${side}-${entry.price}`}
        className={`ladder-row ${side}${crossed ? " crossed" : ""}`}
        title={crossed ? OVERLAP_HINT : undefined}
      >
        <i style={{ width: `${((100 * entry.cumUsd) / maxCum).toFixed(1)}%` }} />
        <span className="sz">{formatUsd(entry.sizeUsd)}</span>
        <span className="cum">{formatUsd(entry.cumUsd)}</span>
        <span className="px">{entry.price.toFixed(decimals)}</span>
      </div>
    );
  };

  return (
    <>
      <h2>
        Orderbook{" "}
        <select
          className="mini-btn"
          value={depth.bin}
          aria-label="Price grouping"
          onChange={(event) => setBinSize(symbol, parseFloat(event.target.value))}
        >
          {(depth.binLadder?.length ? depth.binLadder : [depth.bin]).map((bin) => (
            <option key={bin} value={bin}>grp {formatBin(bin)}</option>
          ))}
        </select>
      </h2>
      <div className="ladder">
        <div className="ladder-side asks">
          {[...asks].reverse().map((entry) => row(entry, "ask"))}
        </div>
        <div className="ladder-mid">
          <b className={lastTrade?.side === "sell" ? "sell-c" : "buy-c"}>
            {(lastTrade?.price ?? depth.mid ?? 0).toFixed(decimals)}
          </b>
          <SpreadReadout best={depth.best} />
        </div>
        <div className="ladder-side bids">
          {bids.map((entry) => row(entry, "bid"))}
        </div>
      </div>
    </>
  );
}

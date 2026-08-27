/* DOM-style orderbook ladder (the Tealstreet/Insilico look Arash asked
   for): asks stacked above, bids below, per-row size + cumulative +
   price with a depth bar behind each row scaled by cumulative share.
   The middle row shows the last trade price (colored by aggressor side)
   and the aggregated spread. The "grp" select is the price-compression
   control: absolute bin sizes drawn from the server's own ladder, which
   is scaled to the symbol's price, so the options offered are exactly the
   ones the server will honour. */

import { formatBin } from "../lib/grouping";
import { formatUsd } from "../lib/format";
import { useLensStore } from "../store/lens";

const LADDER_ROWS = 11; // per side — fits the panel without scrolling

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
  const bestBid = depth.bids[0]?.[0];
  const bestAsk = depth.asks[0]?.[0];
  const spreadBps = bestBid && bestAsk && depth.mid
    ? ((bestAsk - bestBid) / depth.mid) * 10_000 : null;
  const decimals = depth.bin >= 1 ? 0 : Math.min(6, -Math.floor(Math.log10(depth.bin)));

  const row = (entry: Row, side: "bid" | "ask") => (
    <div key={`${side}-${entry.price}`} className={`ladder-row ${side}`}>
      <i style={{ width: `${((100 * entry.cumUsd) / maxCum).toFixed(1)}%` }} />
      <span className="sz">{formatUsd(entry.sizeUsd)}</span>
      <span className="cum">{formatUsd(entry.cumUsd)}</span>
      <span className="px">{entry.price.toFixed(decimals)}</span>
    </div>
  );

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
          {spreadBps !== null && (
            <span className="muted">{spreadBps.toFixed(1)}bp</span>
          )}
        </div>
        <div className="ladder-side bids">
          {bids.map((entry) => row(entry, "bid"))}
        </div>
      </div>
    </>
  );
}

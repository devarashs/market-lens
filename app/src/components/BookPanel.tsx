/* The structure column: orderbook ladder + top walls — resting claims,
   one narrow column so the tape can live in its own (Arash 2026-08-26:
   "2 columns, one for aggr trades and one for order book and top walls"). */

import { formatUsd } from "../lib/format";
import { useLensStore } from "../store/lens";
import { OrderBook } from "./OrderBook";

function WallsTable() {
  const depth = useLensStore((s) => s.depth);
  if (!depth?.walls) return <table id="walls"><tbody /></table>;

  const rows = (["asks", "bids"] as const).flatMap((side) =>
    depth.walls[side].map(([price, usd, byVenue]) => ({
      side,
      price,
      usd,
      dist: depth.mid ? ((price / depth.mid - 1) * 100).toFixed(2) : "?",
      attribution: Object.entries(byVenue ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([venue, value]) => `${venue} $${formatUsd(value)}`)
        .join(" · "),
    })),
  ).sort((a, b) => b.price - a.price);

  return (
    <table id="walls">
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.side}-${row.price}`} title={row.attribution}>
            <td className={row.side === "bids" ? "buy-c" : "sell-c"}>
              {row.side === "bids" ? "BID" : "ASK"}
            </td>
            <td>{row.price.toLocaleString()}</td>
            <td>${formatUsd(row.usd)}</td>
            <td className="muted">{row.dist}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BookPanel() {
  return (
    <aside className="tape" aria-label="Book structure panel">
      <OrderBook />
      <h2>Top walls <span className="muted">(resting, aggregated)</span></h2>
      <WallsTable />
    </aside>
  );
}

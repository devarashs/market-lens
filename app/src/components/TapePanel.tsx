import { MAX_TAPE_ROWS } from "../lib/config";
import { OrderBook } from "./OrderBook";
import { formatUsd, formatUtcTime } from "../lib/format";
import type { LiqEvent, Trade } from "../lib/types";
import { currentThreshold, useLensStore } from "../store/lens";

type TapeRow =
  | { kind: "trade"; ts: number; trade: Trade }
  | { kind: "liq"; ts: number; liq: LiqEvent };

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

export function TapePanel() {
  const trades = useLensStore((s) => s.trades);
  const liqs = useLensStore((s) => s.liqs);
  const activeVenues = useLensStore((s) => s.activeVenues);
  const symbol = useLensStore((s) => s.symbol);
  const thresholdMult = useLensStore((s) => s.thresholdMult);
  const setThresholdMult = useLensStore((s) => s.setThresholdMult);
  const threshold = currentThreshold({ symbol, thresholdMult });

  // One column, both kinds (aggr.trade-style): trades and forced
  // liquidations interleaved by time, same threshold and venue gates —
  // liqs carry venue "binance-fut", now a real listed venue.
  const venueOn = (venue: string) =>
    activeVenues === null || activeVenues.includes(venue);
  const rows: TapeRow[] = [
    ...trades.filter((trade) => trade.notional >= threshold && venueOn(trade.venue))
      .map((trade): TapeRow => ({ kind: "trade", ts: trade.ts, trade })),
    ...liqs.filter((liq) => liq.notional >= threshold && venueOn(liq.venue))
      .map((liq): TapeRow => ({ kind: "liq", ts: liq.ts, liq })),
  ].sort((a, b) => a.ts - b.ts).slice(-MAX_TAPE_ROWS).reverse();

  return (
    <aside className="tape" aria-label="Market structure panel">
      <OrderBook />
      <h2>Top walls <span className="muted">(resting, aggregated)</span></h2>
      <WallsTable />
      <h2>Big trades <span className="muted">≥ ${formatUsd(threshold)}</span></h2>
      <input
        type="range"
        id="threshold"
        min={0.1} max={4} step={0.1}
        value={thresholdMult}
        aria-label="Big trade threshold multiplier"
        onChange={(event) => setThresholdMult(parseFloat(event.target.value))}
      />
      <ul id="tape-list">
        {rows.map((row) => row.kind === "trade" ? (
          <li key={`t-${row.trade.ts}-${row.trade.price}-${row.trade.size}`}
              className={row.trade.side}>
            <span>{row.trade.side === "buy" ? "▲" : "▼"} ${formatUsd(row.trade.notional)}</span>
            <span className="px">
              {row.trade.price.toLocaleString()} · {row.trade.venue} · {formatUtcTime(row.trade.ts)}
            </span>
          </li>
        ) : (
          <li key={`l-${row.liq.ts}-${row.liq.price}-${row.liq.size}`}
              className={`liq-${row.liq.side}`}>
            <span>✕ ${formatUsd(row.liq.notional)} {row.liq.side} liq</span>
            <span className="px">
              {row.liq.price.toLocaleString()} · {row.liq.venue} · {formatUtcTime(row.liq.ts)}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

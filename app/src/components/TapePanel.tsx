import { MAX_TAPE_ROWS } from "../lib/config";
import { formatUsd, formatUtcTime } from "../lib/format";
import { currentThreshold, useLensStore } from "../store/lens";

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
  const symbol = useLensStore((s) => s.symbol);
  const thresholdMult = useLensStore((s) => s.thresholdMult);
  const setThresholdMult = useLensStore((s) => s.setThresholdMult);
  const threshold = currentThreshold({ symbol, thresholdMult });

  const rows = trades
    .filter((trade) => trade.notional >= threshold)
    .slice(-MAX_TAPE_ROWS)
    .reverse();

  return (
    <aside className="tape" aria-label="Market structure panel">
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
        {rows.map((trade) => (
          <li key={`${trade.ts}-${trade.price}-${trade.size}`} className={trade.side}>
            <span>{trade.side === "buy" ? "▲" : "▼"} ${formatUsd(trade.notional)}</span>
            <span className="px">
              {trade.price.toLocaleString()} · {trade.venue} · {formatUtcTime(trade.ts)}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

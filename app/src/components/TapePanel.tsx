import { MAX_TAPE_ROWS } from "../lib/config";
import { formatUsd, formatUtcTime } from "../lib/format";
import type { LiqEvent, Trade } from "../lib/types";
import { currentThreshold, useLensStore } from "../store/lens";

type TapeRow =
  | { kind: "trade"; ts: number; trade: Trade }
  | { kind: "liq"; ts: number; liq: LiqEvent };

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
  const symbolOn = (rowSymbol?: string) =>
    rowSymbol === undefined || rowSymbol === symbol;

  // Row tint deepens with size: a 1x-threshold print sits at ~18% mix, a
  // monster saturates toward 50% -- read the tape's weight by color alone.
  const tint = (colorVar: string, magnitude: number) =>
    `color-mix(in srgb, var(${colorVar}) ` +
    `${Math.min(50, 12 + Math.sqrt(magnitude) * 9).toFixed(0)}%, transparent)`;
  const rows: TapeRow[] = [
    ...trades.filter((trade) => trade.notional >= threshold && venueOn(trade.venue)
        && symbolOn(trade.symbol))
      .map((trade): TapeRow => ({ kind: "trade", ts: trade.ts, trade })),
    ...liqs.filter((liq) => liq.notional >= threshold && venueOn(liq.venue)
        && symbolOn(liq.symbol))
      .map((liq): TapeRow => ({ kind: "liq", ts: liq.ts, liq })),
  ].sort((a, b) => a.ts - b.ts).slice(-MAX_TAPE_ROWS).reverse();

  return (
    <aside className="tape" aria-label="Trade flow panel">
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
              className={row.trade.side}
              style={{ background: tint(
                row.trade.side === "buy" ? "--bid" : "--ask",
                row.trade.notional / threshold) }}>
            <span>{row.trade.side === "buy" ? "▲" : "▼"} ${formatUsd(row.trade.notional)}</span>
            <span className="px">
              {row.trade.price.toLocaleString()} · {row.trade.venue} · {formatUtcTime(row.trade.ts)}
            </span>
          </li>
        ) : (
          <li key={`l-${row.liq.ts}-${row.liq.price}-${row.liq.size}`}
              className={`liq-${row.liq.side}`}
              style={{ background: tint(
                `--color-liq-${row.liq.side}`, row.liq.notional / threshold) }}>
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

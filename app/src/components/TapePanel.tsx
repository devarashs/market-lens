import { memo, useMemo } from "react";

import { MAX_TAPE_ROWS } from "../lib/config";
import { formatUsd } from "../lib/format";
import { tintPercent, visibleRows, type TapeRow } from "../lib/tape";
import { currentThreshold, useLensStore } from "../store/lens";

/** One printed row. Memoised on identity: a new print re-renders itself
    and nothing else, because every row's id is stable for its lifetime.
    The displayed strings were rendered once, when the print arrived. */
const Row = memo(function Row({ row, magnitude }: {
  row: TapeRow; magnitude: number;
}) {
  const { item } = row;
  const percent = tintPercent(magnitude).toFixed(0);
  const colorVar = row.kind === "trade"
    ? (item.side === "buy" ? "--bid" : "--ask")
    : `--color-liq-${item.side}`;
  return (
    <li
      className={`tape-row ${row.kind === "trade" ? item.side : `liq-${item.side}`}`}
      style={{ background: `color-mix(in srgb, var(${colorVar}) ${percent}%, transparent)` }}
    >
      <span>
        {row.kind === "trade"
          ? `${item.side === "buy" ? "▲" : "▼"} $${item.usdText}`
          : `✕ $${item.usdText} ${item.side} liq`}
      </span>
      <span className="px">
        {item.priceText} · {item.venue} · {item.timeText}
      </span>
    </li>
  );
});

export function TapePanel() {
  const trades = useLensStore((s) => s.trades);
  const liqs = useLensStore((s) => s.liqs);
  const activeVenues = useLensStore((s) => s.activeVenues);
  const symbol = useLensStore((s) => s.symbol);
  const thresholdMult = useLensStore((s) => s.thresholdMult);
  const setThresholdMult = useLensStore((s) => s.setThresholdMult);
  const threshold = currentThreshold({ symbol, thresholdMult });

  // Recomputed only when something it reads changes — not on every render
  // of a parent, and not once per arriving print.
  const rows = useMemo(
    () => visibleRows(trades, liqs, threshold, activeVenues, symbol, MAX_TAPE_ROWS),
    [trades, liqs, threshold, activeVenues, symbol],
  );

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
        {rows.map((row) => (
          <Row key={row.item.id} row={row} magnitude={row.item.notional / threshold} />
        ))}
      </ul>
    </aside>
  );
}

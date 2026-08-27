import { memo, useMemo } from "react";

import { MAX_TAPE_ROWS } from "../lib/config";
import { formatUsd, shortVenue } from "../lib/format";
import {
  liqRows, liqTotals, sizeLevel, tradeRows, type LiqItem, type TradeItem,
} from "../lib/tape";
import { currentThreshold, useLensStore } from "../store/lens";

/** Rows kept in the liquidation strip. Deliberately short: it is a strip
    under the tape, not a second tape. */
const LIQ_ROWS = 7;

/** One printed trade. Memoised on identity: a new print re-renders itself
    and nothing else, because every row's id is stable for its lifetime.
    The displayed strings were rendered once, when the print arrived. */
const Row = memo(function Row({ item, level }: {
  item: TradeItem; level: 0 | 1 | 2;
}) {
  return (
    <li className={`tape-row ${item.side} lvl-${level}`}>
      <span>{item.side === "buy" ? "▲" : "▼"} ${item.usdText}</span>
      <span className="px">
        {item.priceText} · {shortVenue(item.venue)} · {item.timeText}
      </span>
    </li>
  );
});

/** Liquidations are rare — a strip of seven can easily span hours — so the
    time is not optional here the way it would be on a busy tape: without
    it there is no telling a forced exit three seconds old from one three
    hours old. */
const LiqRow = memo(function LiqRow({ item }: { item: LiqItem }) {
  return (
    <li className={`liq-row liq-${item.side}`}>
      <span>{item.side === "long" ? "↓" : "↑"} ${item.usdText}</span>
      <span className="px">
        {item.priceText} · {shortVenue(item.venue)} · {item.timeText}
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
    () => tradeRows(trades, threshold, activeVenues, symbol, MAX_TAPE_ROWS),
    [trades, threshold, activeVenues, symbol],
  );
  const forced = useMemo(
    () => liqRows(liqs, activeVenues, symbol, LIQ_ROWS),
    [liqs, activeVenues, symbol],
  );
  const totals = useMemo(() => liqTotals(forced), [forced]);

  return (
    <aside className="tape tape-flow" aria-label="Trade flow panel">
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
        {rows.map((item) => (
          <Row key={item.id} item={item}
               level={sizeLevel(item.notional / threshold)} />
        ))}
      </ul>

      {/* Forced flow, kept out of the tape on purpose: a liquidation is
          not a discretionary print and reads differently. */}
      <section className="liq-strip" aria-label="Recent liquidations">
        <h3>
          Liquidations
          {(totals.long > 0 || totals.short > 0) && (
            <span className="liq-totals">
              <b className="liq-long-c">${formatUsd(totals.long)}</b>
              {" long · "}
              <b className="liq-short-c">${formatUsd(totals.short)}</b>
              {" short"}
            </span>
          )}
        </h3>
        {forced.length === 0 ? (
          <p className="muted liq-empty">none on this symbol yet</p>
        ) : (
          <ul className="liq-list">
            {forced.map((item) => <LiqRow key={item.id} item={item} />)}
          </ul>
        )}
      </section>
    </aside>
  );
}

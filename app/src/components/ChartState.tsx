/* The chart's loading, empty and error states.

   Until now the chart had one state — drawn — and everything else looked
   identical: a blank panel. So a candle load that failed and was quietly
   retrying was indistinguishable from one that had never started, which is
   exactly what "some things show, candles do not" looked like from the
   outside (Arash, reported twice, and not reproducible from here).

   Making failure legible is worth more than another guess at the cause: if
   it happens again it now says which symbol, which interval, what went
   wrong, and how many times it has retried — which is a bug report instead
   of a feeling.

   The overlay never covers a drawn chart. Once rows exist it steps aside
   entirely, so a retry during a routine poll cannot hide the data you are
   already looking at. */

import { useLensStore } from "../store/lens";

export function ChartState() {
  const load = useLensStore((s) => s.candleLoad);
  const rows = useLensStore((s) => s.candleRows.length);
  const symbol = useLensStore((s) => s.symbol);
  const timeframe = useLensStore((s) => s.timeframe);

  // Populated: the chart speaks for itself. A background retry while rows
  // are on screen is not worth interrupting anyone for.
  if (rows > 0) return null;

  if (load.state === "retrying") {
    return (
      <div className="chart-state" role="status">
        <div className="chart-state-card is-error">
          <b>Candles didn’t load</b>
          <span className="muted">
            {symbol} · {timeframe} — {load.reason}
          </span>
          <span className="muted">
            Retrying… attempt {load.attempt}
          </span>
          <button className="mini-btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chart-state" role="status">
      <div className="chart-state-card">
        {/* Three bars that settle in sequence — a candle chart drawing
            itself. Short, small, and transform-only so it costs nothing. */}
        <div className="chart-state-bars" aria-hidden="true">
          <i /><i /><i />
        </div>
        <span className="muted">Loading {symbol} · {timeframe}</span>
      </div>
    </div>
  );
}

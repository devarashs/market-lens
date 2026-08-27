import { Link } from "react-router-dom";

import { CHART_STYLES, type ChartStyle, type Symbol } from "../lib/config";
import { useLensStore } from "../store/lens";
import { SymbolInfoButton } from "./SymbolInfo";
import { SymbolPicker } from "./SymbolPicker";
import { TimeframePicker } from "./TimeframePicker";

/** Kept as pills beside the picker — the everyday watchlist. */
const QUICK_SYMBOLS: readonly Symbol[] = ["BTC", "ETH", "SOL", "HYPE", "NVDA", "GOLD"];

const STYLE_LABELS: Record<ChartStyle, string> = {
  candles: "Candles", heikin: "Heikin-Ashi", bars: "Bars", line: "Line", area: "Area",
};

const STATUS_LABELS = {
  connecting: "connecting…", live: "live", reconnecting: "reconnecting…",
  stale: "stale — reconnecting…",
} as const;

export function Header() {
  const symbol = useLensStore((s) => s.symbol);
  const timeframe = useLensStore((s) => s.timeframe);
  const chartStyle = useLensStore((s) => s.chartStyle);
  const connection = useLensStore((s) => s.connection);
  const metrics = useLensStore((s) => s.metrics);
  const setChartStyle = useLensStore((s) => s.setChartStyle);

  return (
    <header className="top">
      <h1>Market Lens</h1>
      <SymbolPicker />
      {/* The core symbols stay one click away: the picker scales to 50
          symbols, but these are the ones actually watched all day. */}
      <nav id="symbols" aria-label="Quick symbols">
        {QUICK_SYMBOLS.map((sym) => {
          const change = metrics[sym]?.change24h;
          // Real anchors (via Link) so the browser's own right-click /
          // middle-click / ctrl+click "open in new tab" works; left click
          // still routes through the SPA.
          return (
            <Link
              key={sym}
              to={`/${sym}/${timeframe}`}
              className={sym === symbol ? "active" : ""}
            >
              {sym}{" "}
              {change !== undefined && (
                <small className={change >= 0 ? "buy-c" : "sell-c"}>
                  {change >= 0 ? "+" : ""}{change.toFixed(1)}%
                </small>
              )}
            </Link>
          );
        })}
      </nav>
      <TimeframePicker symbol={symbol} timeframe={timeframe} />
      <select
        className="mini-btn"
        aria-label="Chart style"
        value={chartStyle}
        onChange={(event) => setChartStyle(event.target.value as ChartStyle)}
      >
        {CHART_STYLES.map((style) => (
          <option key={style} value={style}>{STYLE_LABELS[style]}</option>
        ))}
      </select>
      <SymbolInfoButton />
      <Link className="mini-btn" to="/markets"
            title="Cross-venue 24h flow per market">markets</Link>
      <Link className="mini-btn" to="/docs" title="Documentation">docs</Link>
      <span className={`status ${connection === "live" ? "live" : ""}`}>
        {STATUS_LABELS[connection]}
      </span>
    </header>
  );
}
